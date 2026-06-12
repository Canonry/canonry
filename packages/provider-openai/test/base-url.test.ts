import { test, expect, vi } from 'vitest'

import { createClient } from '../src/normalize.js'
import { toOpenAIConfig } from '../src/adapter.js'

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input)
}

// --- SDK seam: createClient threads baseUrl into the real OpenAI client ---

test('createClient threads a configured baseUrl into the SDK baseURL', () => {
  const client = createClient({ apiKey: 'k', quotaPolicy, baseUrl: 'https://proxy.example.com/v1' })
  expect(client.baseURL).toBe('https://proxy.example.com/v1')
})

test('createClient falls back to the OpenAI default endpoint when baseUrl is unset', () => {
  const client = createClient({ apiKey: 'k', quotaPolicy })
  expect(client.baseURL).toBe('https://api.openai.com/v1')
})

test('createClient treats an empty-string baseUrl as unset', () => {
  const client = createClient({ apiKey: 'k', quotaPolicy, baseUrl: '' })
  expect(client.baseURL).toBe('https://api.openai.com/v1')
})

// --- Wire guard: a path-prefix baseUrl (LiteLLM passthrough) is preserved, not host-swapped ---

test('createClient preserves the baseUrl path prefix when building request URLs', async () => {
  const calls: string[] = []
  // Stub before constructing — the SDK captures globalThis.fetch at construction.
  vi.stubGlobal('fetch', async (input: unknown) => {
    calls.push(requestUrl(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const client = createClient({
      apiKey: 'tenant-virtual-key',
      quotaPolicy,
      baseUrl: 'https://proxy.example.com/openai_passthrough/v1',
    })
    // The stub body isn't a valid Responses payload; only the requested URL matters.
    await client.responses.create({ model: 'gpt-5.4', input: 'ping' }).catch(() => {})
    expect(calls[0]).toBe('https://proxy.example.com/openai_passthrough/v1/responses')
  } finally {
    vi.unstubAllGlobals()
  }
})

// --- Mapping guard: ProviderConfig.baseUrl must survive the adapter mapping ---

test('toOpenAIConfig carries ProviderConfig.baseUrl into the adapter config', () => {
  const mapped = toOpenAIConfig({
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'https://proxy.example.com/v1',
    quotaPolicy,
  })
  expect(mapped.baseUrl).toBe('https://proxy.example.com/v1')
})

test('toOpenAIConfig leaves baseUrl undefined when ProviderConfig has none', () => {
  const mapped = toOpenAIConfig({ provider: 'openai', apiKey: 'k', quotaPolicy })
  expect(mapped.baseUrl).toBeUndefined()
})
