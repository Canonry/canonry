import type { ProviderConfig } from '@ainyc/canonry-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderModelCatalog } from '../src/provider-model-catalog.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'

const oldModels = openaiAdapter.modelRegistry.knownModels
const freshModels = [{ id: 'gpt-next', displayName: 'Next GPT', tier: 'standard' as const }]
const config = { provider: 'openai', apiKey: 'test-key', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 } }
afterEach(() => vi.useRealTimers())

describe('provider model catalog', () => {
  it('coalesces requests, caches discovery, refreshes, and preserves last good data on failure', async () => {
    vi.useFakeTimers()
    const listModels = vi.fn().mockResolvedValue(freshModels)
    const registry = new ProviderRegistry()
    registry.register({ ...openaiAdapter, listModels }, config)
    const read = createProviderModelCatalog(registry)
    expect(await Promise.all([read('openai'), read('openai')])).toEqual([freshModels, freshModels])
    expect(listModels).toHaveBeenCalledTimes(1)
    await read('openai')
    expect(listModels).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    listModels.mockRejectedValue(new Error('unavailable'))
    expect(await read('openai')).toEqual(freshModels)
    expect(listModels).toHaveBeenCalledTimes(2)
    await read('openai')
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(openaiAdapter.modelRegistry.knownModels).toEqual(oldModels)
  })

  it('invalidates credentials and endpoints, never carrying another account catalog across', async () => {
    const listModels = vi.fn().mockResolvedValue(freshModels)
    const registry = new ProviderRegistry()
    registry.register({ ...openaiAdapter, listModels }, config)
    const read = createProviderModelCatalog(registry)
    await read('openai')
    registry.register({ ...openaiAdapter, listModels }, { ...config, apiKey: 'different-key', baseUrl: 'https://proxy.example/v1' })
    listModels.mockRejectedValue(new Error('unauthorized'))
    expect(await read('openai')).toEqual(oldModels)
    expect(listModels).toHaveBeenCalledTimes(2)
  })

  it('bounds a stalled discovery and falls back without blocking the page', async () => {
    vi.useFakeTimers()
    const registry = new ProviderRegistry()
    const listModels = vi.fn((_config: ProviderConfig, _signal: AbortSignal) => new Promise<never>(() => {}))
    registry.register({ ...openaiAdapter, listModels }, config)
    const read = createProviderModelCatalog(registry)
    const pending = read('openai')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual(oldModels)
    expect(listModels.mock.calls[0]?.[1]?.aborted).toBe(true)
  })

  it('honors a long Retry-After without making the page wait', async () => {
    vi.useFakeTimers()
    const listModels = vi.fn().mockRejectedValue({ status: 429, headers: new Headers({ 'retry-after': '300' }) })
    const registry = new ProviderRegistry()
    registry.register({ ...openaiAdapter, listModels }, config)
    const read = createProviderModelCatalog(registry)
    expect(await read('openai')).toEqual(oldModels)
    await vi.advanceTimersByTimeAsync(60 * 1000)
    await read('openai')
    expect(listModels).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(240 * 1000)
    await read('openai')
    expect(listModels).toHaveBeenCalledTimes(2)
  })

  it.each([{ models: [] }, { models: [{ id: '   ', displayName: 'Blank', tier: 'standard' }] }])('keeps the last good catalog when a refresh has no usable model IDs: %j', async ({ models: response }) => {
    vi.useFakeTimers()
    const listModels = vi.fn().mockResolvedValueOnce(freshModels).mockResolvedValue(response)
    const registry = new ProviderRegistry()
    registry.register({ ...openaiAdapter, listModels }, config)
    const read = createProviderModelCatalog(registry)
    await read('openai')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(await read('openai')).toEqual(freshModels)
    await read('openai')
    expect(listModels).toHaveBeenCalledTimes(2)
  })

})
