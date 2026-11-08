import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAdapter, ProviderConfig } from '@canonry/canonry-contracts'
import { claudeAdapter } from '@canonry/canonry-provider-claude'
import { geminiAdapter } from '@canonry/canonry-provider-gemini'
import { localAdapter } from '@canonry/canonry-provider-local'
import { museAdapter } from '@canonry/canonry-provider-muse'
import { openaiAdapter } from '@canonry/canonry-provider-openai'
import { openrouterAdapter } from '@canonry/canonry-provider-openrouter'
import { perplexityAdapter } from '@canonry/canonry-provider-perplexity'

afterEach(() => { vi.restoreAllMocks() })

const quotaPolicy = { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 }

// Every adapter whose connection test sends a request. Search answer services
// document no free key check today, so their tests send nothing.
const CHECKS: Array<{ adapter: ProviderAdapter; config: ProviderConfig }> = [
  { adapter: geminiAdapter, config: { provider: 'gemini', apiKey: 'test-key', quotaPolicy } },
  { adapter: openaiAdapter, config: { provider: 'openai', apiKey: 'test-key', quotaPolicy } },
  { adapter: claudeAdapter, config: { provider: 'claude', apiKey: 'test-key', quotaPolicy } },
  { adapter: perplexityAdapter, config: { provider: 'perplexity', apiKey: 'test-key', quotaPolicy } },
  { adapter: museAdapter, config: { provider: 'muse', apiKey: 'test-key', quotaPolicy } },
  { adapter: localAdapter, config: { provider: 'local', baseUrl: 'http://127.0.0.1:9/v1', quotaPolicy } },
  { adapter: openrouterAdapter, config: { provider: 'openrouter', apiKey: 'test-key', quotaPolicy } },
]

/** A provider that never answers: each request hangs until its caller cancels it. */
function hangingProvider() {
  const sent: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted) return Promise.reject(signal.reason)
    sent.push(input instanceof Request ? input.url : String(input))
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  return sent
}

const wait = (ms: number) => new Promise<'still running'>(resolve => setTimeout(() => resolve('still running'), ms))

describe('provider connection checks stop once aborted', () => {
  // The route aborts a check it stopped waiting for. Without that, a hung or
  // throttled check keeps retrying, and spending, after the test has answered.
  it.each(CHECKS)('$adapter.name cancels its request and retries nothing more', async ({ adapter, config }) => {
    const sent = hangingProvider()
    const controller = new AbortController()
    const check = adapter.healthcheck(config, controller.signal)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    controller.abort(new Error('The connection test is over.'))
    const outcome = await Promise.race([check, wait(1_500)])
    expect(outcome).toMatchObject({ ok: false })
    expect(sent).toHaveLength(1)
  })
})
