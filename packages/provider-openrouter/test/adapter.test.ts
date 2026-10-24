import { afterEach, expect, test, vi } from 'vitest'
import { openrouterAdapter } from '../src/index.js'
import type { ProviderConfig } from '@canonry/canonry-contracts'

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

/** One `GET /models` entry in the shape OpenRouter publishes it. */
function catalogEntry(id: string, name: string, {
  input = ['text'], output = ['text'], parameters = ['max_tokens', 'temperature', 'tools', 'tool_choice'],
  pricing = { prompt: '0.0000001', completion: '0.0000004', request: '0', image: '0' }, maxCompletion = 65536,
}: { input?: string[]; output?: string[]; parameters?: string[]; pricing?: Record<string, string>; maxCompletion?: number | null } = {}) {
  return {
    id, canonical_slug: id.replace(/:.*$/, ''), name, created: 1758067200, context_length: 1048576,
    architecture: { modality: `${input.join('+')}->${output.join('+')}`, input_modalities: input, output_modalities: output, tokenizer: 'Other', instruct_type: null },
    pricing,
    top_provider: { context_length: 1048576, max_completion_tokens: maxCompletion, is_moderated: false },
    per_request_limits: null, supported_parameters: parameters,
  }
}

test('connection health and catalog use metadata calls and expose usable text models', async () => {
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe('GET')
    return url.endsWith('/auth/key') ? json({ data: { label: 'test' } }) : json({ data: [
      catalogEntry('google/gemini-3.1-flash-lite', 'Gemini', { input: ['text', 'image', 'file'] }),
      catalogEntry('typesafe/jev-1.13', 'Jev'),
      catalogEntry('openrouter/auto', 'Auto Router'),
      catalogEntry('openrouter/free', 'Free Models Router'),
      // Batch routing for a model the catalog already lists on its own.
      catalogEntry('openai/gpt-5-mini', 'OpenAI: GPT-5 Mini', { input: ['text', 'image', 'file'] }),
      catalogEntry('openai/gpt-5-mini:batch', 'OpenAI: GPT-5 Mini (batch)', { input: ['text', 'image', 'file'] }),
      // A free variant answers in text like any other model.
      catalogEntry('deepseek/deepseek-chat-v3.1:free', 'DeepSeek: DeepSeek V3.1 (free)'),
      // Image generators, whether or not they also return text.
      catalogEntry('google/gemini-2.5-flash-image', 'Google: Gemini 2.5 Flash Image', { input: ['image', 'text'], output: ['image', 'text'] }),
      catalogEntry('vendor/image', 'Image only', { output: ['image'] }),
      // Music and speech generators also return text alongside audio.
      catalogEntry('google/lyria-3-pro-preview', 'Google: Lyria 3 Pro Preview', { input: ['text', 'image'], output: ['text', 'audio'] }),
      catalogEntry('openai/gpt-audio', 'OpenAI: GPT Audio', { input: ['text', 'audio'], output: ['text', 'audio'] }),
      // Reads images but answers in text. Cache prices, reasoning and an
      // unpublished output cap reach Aero as catalog metadata.
      catalogEntry('meta-llama/llama-4-maverick', 'Meta: Llama 4 Maverick', {
        input: ['text', 'image'], parameters: ['max_tokens', 'tools', 'tool_choice', 'reasoning', 'include_reasoning'], maxCompletion: null,
        pricing: { prompt: '0.000003', completion: '0.000015', request: '0', image: '0', input_cache_read: '0.0000003', input_cache_write: '0.00000375' },
      }),
      catalogEntry('vendor/no-tools', 'Server-search fallback', { parameters: [] }),
    ] })
  })
  vi.stubGlobal('fetch', transport)
  expect((await openrouterAdapter.healthcheck({ ...config, provider: 'openrouter', model: undefined })).ok).toBe(true)
  // Sweeps list the same IDs and names; the rest is what Aero needs to call a model pi-ai lacks.
  const limits = { contextWindow: 1048576, maxOutputTokens: 65536, pricing: { input: 0.1, output: 0.4 } }
  expect(await openrouterAdapter.listModels!(config, AbortSignal.timeout(3000))).toEqual([
    { id: config.model, displayName: 'Gemini', tier: 'standard', ...limits, inputModalities: ['text', 'image', 'file'], supportsTools: true, supportsReasoning: false },
    { id: 'openai/gpt-5-mini', displayName: 'OpenAI: GPT-5 Mini', tier: 'standard', ...limits, inputModalities: ['text', 'image', 'file'], supportsTools: true, supportsReasoning: false },
    { id: 'deepseek/deepseek-chat-v3.1:free', displayName: 'DeepSeek: DeepSeek V3.1 (free)', tier: 'standard', ...limits, inputModalities: ['text'], supportsTools: true, supportsReasoning: false },
    { id: 'meta-llama/llama-4-maverick', displayName: 'Meta: Llama 4 Maverick', tier: 'standard', contextWindow: 1048576,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, inputModalities: ['text', 'image'], supportsTools: true, supportsReasoning: true },
    { id: 'vendor/no-tools', displayName: 'Server-search fallback', tier: 'standard', ...limits, inputModalities: ['text'], supportsTools: false, supportsReasoning: false },
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

// The documented shape of a provider failure after headers were sent on a
// non-streaming request: HTTP 200, partial text, finish_reason "error" and an
// error object on the choice (openrouter.ai/docs/api-reference/errors).
function failedMidAnswer(code = 502) {
  return {
    id: 'gen-1', model: 'google/gemini-3.1-flash-lite-20260917', object: 'chat.completion',
    choices: [{
      index: 0, finish_reason: 'error', native_finish_reason: 'error',
      message: { role: 'assistant', content: 'Popular widget makers include Northstar and' },
      error: { code, message: 'Provider disconnected mid-stream', metadata: { error_type: 'provider_error' } },
    }],
  }
}

test('a cut-off answer is a failed request, never a stored answer', async () => {
  vi.useFakeTimers()
  const transport = vi.fn(async () => json(failedMidAnswer()))
  vi.stubGlobal('fetch', transport)
  const pending = openrouterAdapter.executeTrackedQuery(input, config)
  const outcome = expect(pending).rejects.toThrow('HTTP 502')
  await vi.runAllTimersAsync()
  await outcome
  // A provider disconnect is transient, so it was retried before giving up.
  expect(transport.mock.calls.length).toBeGreaterThan(1)
  expect(() => openrouterAdapter.parseTrackedQueryResponse!(failedMidAnswer(), config.model!)).toThrow('HTTP 502')
})

test('a cut-off answer is retried, and the next complete answer is the one kept', async () => {
  vi.useFakeTimers()
  const transport = vi.fn(async () => json(response([], 1))).mockResolvedValueOnce(json(failedMidAnswer()))
  vi.stubGlobal('fetch', transport)
  const pending = openrouterAdapter.executeTrackedQuery(input, config)
  await vi.runAllTimersAsync()
  const raw = await pending
  expect(transport).toHaveBeenCalledTimes(2)
  expect(openrouterAdapter.normalizeResult(raw).answerText).toBe('Northstar has widgets. https://uncited.example')
})

test('a choice-level error without a code still fails, and a client error is not retried', async () => {
  const noCode = failedMidAnswer()
  delete (noCode.choices[0] as { error?: unknown }).error
  expect(() => openrouterAdapter.parseTrackedQueryResponse!(noCode, config.model!)).toThrow('HTTP 502')
  const transport = vi.fn(async () => json(failedMidAnswer(400)))
  vi.stubGlobal('fetch', transport)
  await expect(openrouterAdapter.executeTrackedQuery(input, config)).rejects.toThrow('HTTP 400')
  expect(transport).toHaveBeenCalledTimes(1)
})
