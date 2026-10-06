import { test, expect, vi, beforeEach, afterEach } from 'vitest'

import { openaiAdapter } from '../src/adapter.js'
import { stubResponsesApi } from './support/responses-api.js'

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

beforeEach(() => {
  vi.stubEnv('OPENAI_BASE_URL', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// --- Wire guard: a path-prefix baseUrl (LiteLLM passthrough) is preserved, not host-swapped ---

test("createClient preserves the baseUrl path prefix when building request URLs", async () => {
  const response = {
    id: 'resp_proxy', object: 'response', status: 'completed', model: 'gpt-5.4-2026-03-05',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'proxy answer', annotations: [] }] }],
  }
  for (const row of [
    { name: 'configured proxy', baseUrl: 'https://proxy.example.com/v1', url: 'https://proxy.example.com/v1/responses' },
    { name: 'unset default', baseUrl: undefined, url: 'https://api.openai.com/v1/responses' },
    { name: 'empty default', baseUrl: '', url: 'https://api.openai.com/v1/responses' },
    { name: 'proxy path prefix', baseUrl: 'https://proxy.example.com/openai_passthrough/v1', url: 'https://proxy.example.com/openai_passthrough/v1/responses' },
  ]) {
    const sent = stubResponsesApi(response)
    const result = await openaiAdapter.executeTrackedQuery(
      { query: 'ping', canonicalDomains: [], competitorDomains: [] },
      { provider: 'openai', apiKey: 'tenant-virtual-key', baseUrl: row.baseUrl, quotaPolicy },
    )
    expect(sent, row.name).toEqual([{
      url: row.url, method: 'POST', authorization: 'Bearer tenant-virtual-key',
      body: { model: 'gpt-5.4', tools: [{ type: 'web_search' }], tool_choice: 'required', input: 'ping' },
    }])
    expect(result, row.name).toEqual({
      provider: 'openai', model: 'gpt-5.4', servedModel: 'gpt-5.4-2026-03-05',
      rawResponse: { ...response, output_text: 'proxy answer' },
      groundingSources: [], searchQueries: [], retrievalStatus: 'not-used',
      retrievalContract: 'search-required-v1', usage: undefined, stopReason: 'completed',
    })
  }
})
