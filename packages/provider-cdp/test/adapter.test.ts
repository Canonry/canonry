import { describe, it, expect } from 'vitest'
import { cdpChatgptAdapter } from '../src/adapter.js'
import type { ProviderConfig } from '@ainyc/canonry-contracts'

const baseConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  provider: 'cdp:chatgpt',
  quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 4, maxRequestsPerDay: 200 },
  ...overrides,
})

describe('cdpChatgptAdapter.name', () => {
  it('is cdp:chatgpt', () => {
    expect(cdpChatgptAdapter.name).toBe('cdp:chatgpt')
  })
})

describe('cdpChatgptAdapter.validateConfig', () => {
  it('returns ok: false when cdpEndpoint is not set', () => {
    const result = cdpChatgptAdapter.validateConfig(baseConfig())
    expect(result.ok).toBe(false)
    expect(result.provider).toBe('cdp:chatgpt')
    expect(result.message).toMatch(/not configured/i)
  })

  it('returns ok: false when cdpEndpoint is empty string', () => {
    const result = cdpChatgptAdapter.validateConfig(baseConfig({ cdpEndpoint: '' }))
    expect(result.ok).toBe(false)
  })

  it('returns ok: true with a full ws:// endpoint', () => {
    const result = cdpChatgptAdapter.validateConfig(baseConfig({ cdpEndpoint: 'ws://localhost:9222' }))
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('cdp:chatgpt')
    expect(result.message).toContain('ws://localhost:9222')
  })

  it('returns ok: true with a plain host:port endpoint', () => {
    const result = cdpChatgptAdapter.validateConfig(baseConfig({ cdpEndpoint: 'localhost:9222' }))
    expect(result.ok).toBe(true)
  })

  it('returns ok: true with a remote host', () => {
    const result = cdpChatgptAdapter.validateConfig(baseConfig({ cdpEndpoint: 'ws://my-host.tailnet:9333' }))
    expect(result.ok).toBe(true)
    expect(result.message).toContain('my-host.tailnet')
  })
})

describe('cdpChatgptAdapter.generateText', () => {
  it('throws — browser providers do not support generateText', async () => {
    await expect(
      cdpChatgptAdapter.generateText('test prompt', baseConfig({ cdpEndpoint: 'ws://localhost:9222' })),
    ).rejects.toThrow()
  })
})

describe('cdpChatgptAdapter.normalizeResult', () => {
  it('returns provider cdp:chatgpt', () => {
    const raw = {
      provider: 'cdp:chatgpt' as const,
      rawResponse: { answerText: 'The answer.', groundingSources: [] },
      model: 'chatgpt-web',
      groundingSources: [],
      searchQueries: ['test query'],
    }
    const result = cdpChatgptAdapter.normalizeResult(raw)
    expect(result.provider).toBe('cdp:chatgpt')
  })

  it('extracts answer text from rawResponse', () => {
    const raw = {
      provider: 'cdp:chatgpt' as const,
      rawResponse: { answerText: 'Paris is the capital.', groundingSources: [] },
      model: 'chatgpt-web',
      groundingSources: [],
      searchQueries: ['capital of France'],
    }
    const result = cdpChatgptAdapter.normalizeResult(raw)
    expect(result.answerText).toBe('Paris is the capital.')
  })

  it('extracts cited domains from grounding sources', () => {
    const raw = {
      provider: 'cdp:chatgpt' as const,
      rawResponse: {
        answerText: 'Some answer.',
        groundingSources: [
          { uri: 'https://www.example.com/article', title: 'Example' },
          { uri: 'https://other.org/page', title: 'Other' },
        ],
      },
      model: 'chatgpt-web',
      groundingSources: [
        { uri: 'https://www.example.com/article', title: 'Example' },
        { uri: 'https://other.org/page', title: 'Other' },
      ],
      searchQueries: ['test'],
    }
    const result = cdpChatgptAdapter.normalizeResult(raw)
    expect(result.citedDomains).toContain('example.com')
    expect(result.citedDomains).toContain('other.org')
  })

  it('returns empty answer text when rawResponse.answerText is missing', () => {
    const raw = {
      provider: 'cdp:chatgpt' as const,
      rawResponse: { groundingSources: [] },
      model: 'chatgpt-web',
      groundingSources: [],
      searchQueries: [],
    }
    const result = cdpChatgptAdapter.normalizeResult(raw)
    expect(result.answerText).toBe('')
  })
})
