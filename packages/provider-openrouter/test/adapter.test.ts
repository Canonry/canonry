import { afterEach, expect, test, vi } from 'vitest'
import { openrouterAdapter } from '../src/index.js'
import type { ProviderConfig } from '@ainyc/canonry-contracts'

const config: ProviderConfig = {
  provider: 'openrouter:google/gemini-3.1-flash-lite', model: 'google/gemini-3.1-flash-lite', apiKey: 'test-key',
  quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 },
}
const input = { query: 'best widgets', canonicalDomains: ['example.com'], competitorDomains: [], location: { label: 'New York', city: 'New York', country: 'US' } }
function response(annotations: unknown[] = [], searches?: number, usage: Record<string, unknown> = { input_tokens: 20, output_tokens: 5 }) {
  return { model: 'google/gemini-3.1-flash-lite-20260917', choices: [{ finish_reason: 'stop', message: { content: 'Northstar has widgets. https://uncited.example', annotations } }],
    usage: { ...usage, ...(searches === undefined ? {} : { server_tool_use: { web_search_requests: searches } }) } }
}
function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

test('tracked queries request search and retain literal model and citation evidence', async () => {
  const body = response([
    { type: 'url_citation', url_citation: { url: 'https://www.example.com/widgets', title: 'Widgets' } },
    { type: 'url_citation', url_citation: { url: 'https://www.example.com/widgets', title: 'Widgets' } },
    { type: 'url_citation', url_citation: { url: 'javascript:alert(1)' } },
  ], 2)
  const transport = vi.fn(async () => json(body))
  vi.stubGlobal('fetch', transport)
  const raw = await openrouterAdapter.executeTrackedQuery(input, config)
  expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
    model: config.model, messages: [{ role: 'user', content: 'best widgets' }], stream: false,
    tools: [{ type: 'openrouter:web_search', parameters: { max_uses: 1, max_total_results: 5 } }],
    tool_choice: 'required', max_tool_calls: 1, provider: { allow_fallbacks: false, require_parameters: true },
  })
  expect(raw).toMatchObject({ provider: config.provider, model: config.model, servedModel: 'google/gemini-3.1-flash-lite-20260917',
    retrievalContract: 'search-required-v1', retrievalStatus: 'used', usage: { inputTokens: 20, outputTokens: 5, searchCount: 2 } })
  expect(openrouterAdapter.normalizeResult(raw)).toMatchObject({
    answerText: 'Northstar has widgets. https://uncited.example', citedDomains: ['example.com'],
    groundingSources: [{ uri: 'https://www.example.com/widgets', title: 'Widgets' }],
  })
})

test('prose URLs are not citations and missing search evidence stays unknown', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(response())))
  const raw = await openrouterAdapter.executeTrackedQuery(input, config)
  expect(raw.retrievalStatus).toBe('unknown')
  expect(openrouterAdapter.normalizeResult(raw).citedDomains).toEqual([])
  expect(raw.servedModel).toBe('google/gemini-3.1-flash-lite-20260917')
})

test('legacy chat-completions token fields remain compatible', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(response([], 1, {
    prompt_tokens: 20,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 3 },
  }))))
  const raw = await openrouterAdapter.executeTrackedQuery(input, config)
  expect(raw.usage).toEqual({ inputTokens: 17, cachedInputTokens: 3, cacheWriteTokens: 0, outputTokens: 5, searchCount: 1 })
})

test('connection health and catalog use metadata calls and expose usable text models', async () => {
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe('GET')
    return url.endsWith('/auth/key') ? json({ data: { label: 'test' } }) : json({ data: [
      { id: 'google/gemini-3.1-flash-lite', name: 'Gemini', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
      { id: 'typesafe/jev-1.13', architecture: { output_modalities: ['text'] } },
      { id: 'openrouter/auto', supported_parameters: ['tools'] },
      { id: 'openrouter/free', supported_parameters: ['tools'] },
      { id: 'vendor/image', architecture: { output_modalities: ['image'] }, supported_parameters: ['tools'] },
      { id: 'vendor/no-tools', name: 'Server-search fallback', architecture: { output_modalities: ['text'] }, supported_parameters: [] },
    ] })
  })
  vi.stubGlobal('fetch', transport)
  expect((await openrouterAdapter.healthcheck({ ...config, provider: 'openrouter', model: undefined })).ok).toBe(true)
  expect(await openrouterAdapter.listModels!(config, AbortSignal.timeout(3000))).toEqual([
    { id: config.model, displayName: 'Gemini', tier: 'standard' },
    { id: 'vendor/no-tools', displayName: 'Server-search fallback', tier: 'standard' },
  ])
  expect(transport.mock.calls.map(([url]) => url)).toEqual(['https://openrouter.ai/api/v1/auth/key', 'https://openrouter.ai/api/v1/models'])
})

test('throttled requests honor Retry-After; rejected credentials are never retried', async () => {
  vi.useFakeTimers()
  const transport = vi.fn(async () => json(response())).mockResolvedValueOnce(json({}, 429, { 'Retry-After': '2' }))
  vi.stubGlobal('fetch', transport)
  const pending = openrouterAdapter.executeTrackedQuery(input, config)
  await vi.advanceTimersByTimeAsync(1999)
  expect(transport).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(transport).toHaveBeenCalledTimes(2)
  transport.mockReset().mockResolvedValue(json({}, 401))
  await expect(openrouterAdapter.executeTrackedQuery(input, config)).rejects.toThrow('HTTP 401')
  expect(transport).toHaveBeenCalledTimes(1)
})

test('a route cannot silently switch models', async () => {
  const transport = vi.fn()
  vi.stubGlobal('fetch', transport)
  await expect(openrouterAdapter.executeTrackedQuery(input, { ...config, model: 'anthropic/claude-sonnet-4.6' })).rejects.toThrow('cannot be overridden')
  expect(transport).not.toHaveBeenCalled()
})
