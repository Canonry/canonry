import { test, expect, vi } from 'vitest'

import { createClient } from '../src/normalize.js'
import { createEmbedGenAI, embedQueries } from '../src/embeddings.js'
import { toGeminiConfig } from '../src/adapter.js'

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

// The SDK stores `httpOptions` as a runtime property (TS `private`, not `#private`),
// so we read it back off the real constructed instance.
type ClientInternals = { httpOptions?: { baseUrl?: string }; vertexai?: boolean }
const internals = (client: unknown) => client as ClientInternals

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input)
}

// --- SDK seam: createClient threads baseUrl into the real GoogleGenAI client ---

test('createClient threads baseUrl into httpOptions.baseUrl (AI Studio mode)', () => {
  const client = createClient({ apiKey: 'k', quotaPolicy, baseUrl: 'https://proxy.example.com' })
  expect(internals(client).httpOptions?.baseUrl).toBe('https://proxy.example.com')
})

test('createClient leaves httpOptions unset when no baseUrl is configured', () => {
  const client = createClient({ apiKey: 'k', quotaPolicy })
  expect(internals(client).httpOptions).toBeUndefined()
})

test('createClient threads baseUrl into httpOptions for Vertex AI mode', () => {
  const client = createClient({
    apiKey: '',
    quotaPolicy,
    vertexProject: 'proj',
    vertexRegion: 'us-central1',
    baseUrl: 'https://proxy.example.com',
  })
  expect(internals(client).vertexai).toBe(true)
  expect(internals(client).httpOptions?.baseUrl).toBe('https://proxy.example.com')
})

// --- Embeddings seam: discovery's embed client honors the same baseUrl ---

test('createEmbedGenAI threads baseUrl into httpOptions.baseUrl', () => {
  const client = createEmbedGenAI('k', 'https://proxy.example.com')
  expect(internals(client).httpOptions?.baseUrl).toBe('https://proxy.example.com')
})

test('createEmbedGenAI leaves httpOptions unset when no baseUrl is configured', () => {
  const client = createEmbedGenAI('k')
  expect(internals(client).httpOptions).toBeUndefined()
})

// --- Wire guard: a path-prefix baseUrl (LiteLLM passthrough) is preserved, not host-swapped ---

test('createClient preserves the baseUrl path prefix when building sweep request URLs', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    calls.push(requestUrl(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const client = createClient({ apiKey: 'tenant-virtual-key', quotaPolicy, baseUrl: 'https://proxy.example.com/gemini' })
    await client.models.generateContent({ model: 'gemini-2.5-flash', contents: 'ping' }).catch(() => {})
    expect(calls[0]).toMatch(/^https:\/\/proxy\.example\.com\/gemini\/.*:generateContent/)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('embedQueries preserves the baseUrl path prefix when building embed request URLs', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    calls.push(requestUrl(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    // The stub body fails embedding extraction; only the requested URL matters.
    await embedQueries(['ping'], { apiKey: 'tenant-virtual-key', baseUrl: 'https://proxy.example.com/gemini' }).catch(() => {})
    // `:embedContent` (single) or `:batchEmbedContents` (batch) — either way the prefix must survive.
    expect(calls[0]).toMatch(/^https:\/\/proxy\.example\.com\/gemini\/.*[eE]mbed/)
  } finally {
    vi.unstubAllGlobals()
  }
})

// --- Mapping guard: ProviderConfig.baseUrl must survive the adapter mapping ---

test('toGeminiConfig carries ProviderConfig.baseUrl into the adapter config', () => {
  const mapped = toGeminiConfig({
    provider: 'gemini',
    apiKey: 'k',
    baseUrl: 'https://proxy.example.com',
    quotaPolicy,
  })
  expect(mapped.baseUrl).toBe('https://proxy.example.com')
})

test('toGeminiConfig leaves baseUrl undefined when ProviderConfig has none', () => {
  const mapped = toGeminiConfig({ provider: 'gemini', apiKey: 'k', quotaPolicy })
  expect(mapped.baseUrl).toBeUndefined()
})
