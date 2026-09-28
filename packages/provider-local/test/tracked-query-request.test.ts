import { test, expect, onTestFinished } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { localAdapter } from '../src/adapter.js'

// Pins the build/parse split of the sync path: the body `buildTrackedQueryRequest`
// returns is the JSON the SDK puts on the wire, and the sync result is exactly
// `parseTrackedQueryResponse` of the response it received. A real loopback
// server stands in for the runtime: this package pins the openai SDK at v4,
// which resolves `fetch` at import, so a `fetch` stub never sees the request.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const QUERY = { query: 'best crm for agencies', canonicalDomains: ['example.com'], competitorDomains: [] }
const LOCATION = { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US' }

/** An Ollama-style chat completion. */
const COMPLETION = {
  id: 'chatcmpl-812',
  object: 'chat.completion',
  created: 1758700000,
  model: 'llama3:8b-instruct-q4_0',
  system_fingerprint: 'fp_ollama',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Example CRM (example.com) is popular.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 61, completion_tokens: 212, total_tokens: 273 },
}

interface CapturedRequest {
  path: string
  body: Record<string, unknown>
}

/** Serve `response` to every request, capturing each one; returns the base URL. */
async function startRuntime(response: Record<string, unknown>): Promise<{ baseUrl: string; sent: CapturedRequest[] }> {
  const sent: CapturedRequest[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      sent.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}/v1`, sent }
}

function configFor(baseUrl: string) {
  return { provider: 'local', apiKey: '', baseUrl, model: 'llama3', quotaPolicy }
}

test('buildTrackedQueryRequest returns the exact body the sync path sends', async () => {
  const { baseUrl, sent } = await startRuntime(COMPLETION)
  const config = configFor(baseUrl)
  await localAdapter.executeTrackedQuery(QUERY, config)

  const built = localAdapter.buildTrackedQueryRequest!(QUERY, config)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual(built.body)
  expect(sent[0]!.path).toBe(`/v1${built.endpoint}`)
  expect(built.endpoint).toBe('/chat/completions')
  expect(built.body).toEqual({
    model: 'llama3',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. Provide comprehensive, factual answers. When mentioning websites or services, include their domain names.',
      },
      {
        role: 'user',
        content: 'Based on your training knowledge, what websites, services, or organizations are commonly associated with "best crm for agencies"? List the most relevant ones and include their domain names (e.g. example.com) where you know them.',
      },
    ],
  })
})

test('a location reaches the wire through the built body', async () => {
  const { baseUrl, sent } = await startRuntime(COMPLETION)
  const config = configFor(baseUrl)
  const input = { ...QUERY, location: LOCATION }
  await localAdapter.executeTrackedQuery(input, config)

  const built = localAdapter.buildTrackedQueryRequest!(input, config)
  expect(sent[0]!.body).toEqual(built.body)
  expect(JSON.stringify(built.body)).toContain('The user is searching from San Francisco, CA, US.')
})

test('the sync result is exactly parseTrackedQueryResponse of the response received', async () => {
  const { baseUrl } = await startRuntime(COMPLETION)
  const viaSync = await localAdapter.executeTrackedQuery(QUERY, configFor(baseUrl))
  const viaParse = localAdapter.parseTrackedQueryResponse!(structuredClone(COMPLETION), 'llama3')

  expect(viaSync).toEqual(viaParse)
  expect(viaParse.rawResponse).toEqual(COMPLETION)
  expect(viaParse.servedModel).toBe('llama3:8b-instruct-q4_0')
  expect(viaParse.groundingSources).toEqual([])
  expect(viaParse.retrievalStatus).toBe('not-applicable')
})

test('parse reads tokens from the usage object; a local model runs no searches', () => {
  const raw = localAdapter.parseTrackedQueryResponse!(structuredClone(COMPLETION), 'llama3')
  expect(raw.usage).toEqual({
    inputTokens: 61,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 212,
    searchCount: 0,
  })
  expect(raw.stopReason).toBe('stop')
})

test('a runtime that reports no usage leaves usage undefined', () => {
  const { usage: _usage, ...bare } = structuredClone(COMPLETION)
  expect(localAdapter.parseTrackedQueryResponse!(bare, 'llama3').usage).toBeUndefined()
})

test('usage fields the runtime omits read as 0', () => {
  const partial = { ...structuredClone(COMPLETION), usage: { completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }
  expect(localAdapter.parseTrackedQueryResponse!(partial, 'llama3').usage).toEqual({
    inputTokens: 0,
    cachedInputTokens: 3,
    cacheWriteTokens: 0,
    outputTokens: 7,
    searchCount: 0,
  })
})
