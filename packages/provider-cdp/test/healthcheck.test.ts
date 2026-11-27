import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@canonry/canonry-contracts'

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup }))

const { cdpChatgptAdapter } = await import('../src/adapter.js')

afterEach(() => {
  vi.restoreAllMocks()
  lookup.mockReset()
})

const config = (cdpEndpoint: string): ProviderConfig => ({
  provider: 'cdp:chatgpt',
  cdpEndpoint,
  quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 4, maxRequestsPerDay: 200 },
})

const versionUrls = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.map(([input]) => String(input))

describe('cdpChatgptAdapter.healthcheck', () => {
  // Chrome refuses a Host header that names anything but an IP address or
  // localhost, so the version read goes to the address the host resolves to.
  it.each([
    { endpoint: 'ws://chrome.internal:9333', resolved: { address: '10.0.0.5', family: 4 }, url: 'http://10.0.0.5:9333/json/version' },
    { endpoint: 'chrome.internal:9333', resolved: { address: 'fd00::5', family: 6 }, url: 'http://[fd00::5]:9333/json/version' },
  ])('reads the browser version from $resolved.address', async ({ endpoint, resolved, url }) => {
    lookup.mockResolvedValueOnce(resolved)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Browser: 'Chrome/131.0.6778.86', 'Protocol-Version': '1.3' }))
    const result = await cdpChatgptAdapter.healthcheck(config(endpoint))
    expect(result).toEqual({ ok: true, provider: 'cdp:chatgpt', message: 'Connected to Chrome/131.0.6778.86 via CDP', model: 'chatgpt-web' })
    expect(lookup).toHaveBeenCalledWith('chrome.internal')
    expect(versionUrls(fetch)).toEqual([url])
  })

  it.each([
    // Another service on the port can answer JSON that is not Chrome's version.
    { case: 'answers with an error status', answer: () => Promise.resolve(Response.json({ error: 'Not Found' }, { status: 404 })) },
    { case: 'refuses the connection', answer: () => Promise.reject(new TypeError('fetch failed')) },
  ])('reports Chrome unreachable when the version endpoint $case', async ({ answer }) => {
    lookup.mockResolvedValueOnce({ address: '127.0.0.1', family: 4 })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(answer)
    const result = await cdpChatgptAdapter.healthcheck(config('127.0.0.1:9333'))
    expect(versionUrls(fetch)).toEqual(['http://127.0.0.1:9333/json/version'])
    expect(result).toEqual({
      ok: false,
      provider: 'cdp:chatgpt',
      message: 'Chrome not reachable at 127.0.0.1:9333. Ensure Chrome is running with --remote-debugging-port=9333',
    })
  })
})
