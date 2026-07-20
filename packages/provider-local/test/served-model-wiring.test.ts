import { test, expect, onTestFinished } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { localAdapter } from '../src/adapter.js'

// Wiring guard for the served-model path — see the note in
// packages/provider-openai/test/served-model-wiring.test.ts. Extraction is pinned in
// normalize.test.ts; the `servedModel:` line in `executeTrackedQuery` and the
// adapter's `servedModel: raw.servedModel` pass-through had no test.
//
// This one matters most for local models: the served identity is whatever the local
// runtime decided to load (a quantization tag, a different revision), which routinely
// differs from the short name configured.
//
// A real loopback server stands in for the OpenAI-compatible runtime rather than a
// `fetch` stub: this package pins the openai SDK at v4, which resolves `fetch` when
// the module is imported, so `vi.stubGlobal('fetch')` never reaches it. The response
// body is a hand-written minimal chat completion (constructed, not a capture); only
// `model` is load-bearing here.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

const CONFIGURED_MODEL = 'llama3'
const SERVED_MODEL = 'llama3:8b-instruct-q4_0'

function completion(model?: string): Record<string, unknown> {
  return {
    id: 'cmpl_stub',
    object: 'chat.completion',
    created: 0,
    ...(model === undefined ? {} : { model }),
    choices: [
      { index: 0, message: { role: 'assistant', content: 'stub answer' }, finish_reason: 'stop' },
    ],
  }
}

/** Serve one canned chat-completion body and return the OpenAI-compatible base URL. */
async function startRuntime(body: Record<string, unknown>): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

test('the local adapter carries the served model from the API response to RawQueryResult', async () => {
  const baseUrl = await startRuntime(completion(SERVED_MODEL))
  const result = await localAdapter.executeTrackedQuery(
    { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
    { provider: 'local', apiKey: '', baseUrl, model: CONFIGURED_MODEL, quotaPolicy },
  )
  expect(result.model).toBe(CONFIGURED_MODEL)
  expect(result.servedModel).toBe(SERVED_MODEL)
  expect(result.servedModel).not.toBe(result.model)
})

test('the local adapter leaves servedModel undefined when the response discloses no model', async () => {
  const baseUrl = await startRuntime(completion())
  const result = await localAdapter.executeTrackedQuery(
    { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
    { provider: 'local', apiKey: '', baseUrl, model: CONFIGURED_MODEL, quotaPolicy },
  )
  expect(result.servedModel).toBeUndefined()
  expect(result.servedModel).not.toBe(CONFIGURED_MODEL)
})
