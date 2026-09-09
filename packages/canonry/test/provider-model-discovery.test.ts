import { afterEach, describe, expect, it, vi } from 'vitest'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { localAdapter } from '@ainyc/canonry-provider-local'

const quotaPolicy = { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function mock(...bodies: unknown[]) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(bodies.shift()), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('SDK model discovery', () => {
  it('reads OpenAI metadata at the configured endpoint and excludes non-answer models', async () => {
    const fetch = mock({ object: 'list', data: [{ id: 'gpt-future', created: 1 }, { id: 'chat-latest', created: 2 }, { id: 'text-embedding-3-large' }, { id: 'gpt-image-2' }, { id: 'gpt-audio' }, { id: 'gpt-codex' }] })
    const result = await openaiAdapter.listModels!({ provider: 'openai', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1', quotaPolicy }, new AbortController().signal)
    expect(result.map(model => model.id)).toEqual(['gpt-future', 'chat-latest'])
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://proxy.example/v1/models')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('follows Claude pagination and preserves provider display names', async () => {
    const fetch = mock(
      { data: [{ id: 'claude-sonnet-new', display_name: 'Claude Sonnet New', created_at: '2026-09-09T00:00:00Z', type: 'model' }], has_more: true, last_id: 'claude-sonnet-new' },
      { data: [{ id: 'claude-opus-new', display_name: 'Claude Opus New', created_at: '2026-09-09T00:00:00Z', type: 'model' }], has_more: false, last_id: 'claude-opus-new' },
    )
    const result = await claudeAdapter.listModels!({ provider: 'claude', apiKey: 'test-key', quotaPolicy }, new AbortController().signal)
    expect(result.map(model => model.displayName)).toEqual(['Claude Sonnet New', 'Claude Opus New'])
    expect(String(fetch.mock.calls[1]?.[0])).toContain('after_id=claude-sonnet-new')
    expect(fetch.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
  })

  it('follows Gemini pagination and keeps only answer-generation model choices', async () => {
    const fetch = mock(
      { models: [{ name: 'models/gemini-next-flash', displayName: 'Gemini Next Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page-two' },
      { models: [{ name: 'models/gemini-next-pro', displayName: 'Gemini Next Pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-image', supportedGenerationMethods: ['generateContent'] }] },
    )
    const result = await geminiAdapter.listModels!({ provider: 'gemini', apiKey: 'test-key', quotaPolicy }, new AbortController().signal)
    expect(result.map(model => model.id)).toEqual(['gemini-next-flash', 'gemini-next-pro'])
    expect(String(fetch.mock.calls[1]?.[0])).toContain('pageToken=page-two')
    expect(fetch.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
  })

  it('retains custom local model IDs at the configured endpoint', async () => {
    const fetch = mock({ object: 'list', data: [{ id: 'custom-answer-model:latest' }] })
    expect(await localAdapter.listModels!({ provider: 'local', baseUrl: 'http://localhost:11434/v1', quotaPolicy }, new AbortController().signal)).toMatchObject([{ id: 'custom-answer-model:latest' }])
    expect(String(fetch.mock.calls[0]?.[0])).toBe('http://localhost:11434/v1/models')
  })

  it.each([openaiAdapter, claudeAdapter, geminiAdapter])('$name does not retry authentication errors', async adapter => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad key', type: 'authentication_error', code: 401, status: 'UNAUTHENTICATED' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(adapter.listModels!({ provider: adapter.name, apiKey: 'test-key', quotaPolicy }, new AbortController().signal)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([openaiAdapter, claudeAdapter, geminiAdapter])('$name retries a transient failure', async adapter => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(adapter.name === 'gemini' ? { models: [] } : { data: [], has_more: false, object: 'list' }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(adapter.listModels!({ provider: adapter.name, apiKey: 'test-key', quotaPolicy }, new AbortController().signal)).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
