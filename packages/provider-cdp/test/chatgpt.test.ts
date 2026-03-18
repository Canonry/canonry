import { describe, it, expect } from 'vitest'
import { chatgptTarget } from '../src/targets/chatgpt.js'
import type CDP from 'chrome-remote-interface'

// Build a simple mock CDP.Client
function makeMockClient(evalResult: unknown): CDP.Client {
  return {
    Runtime: {
      evaluate: async () => ({ result: { value: evalResult } }),
    },
  } as unknown as CDP.Client
}

// ─── Static properties ────────────────────────────────────────────────────────

describe('chatgptTarget static properties', () => {
  it('name is chatgpt', () => {
    expect(chatgptTarget.name).toBe('chatgpt')
  })

  it('baseUrl points to chatgpt.com', () => {
    expect(chatgptTarget.baseUrl).toBe('https://chatgpt.com')
  })

  it('newConversationUrl is defined and non-empty', () => {
    expect(typeof chatgptTarget.newConversationUrl).toBe('string')
    expect(chatgptTarget.newConversationUrl.length).toBeGreaterThan(0)
  })

  it('responseSelector is defined and non-empty', () => {
    expect(typeof chatgptTarget.responseSelector).toBe('string')
    expect(chatgptTarget.responseSelector.length).toBeGreaterThan(0)
  })

  it('exposes all required CDPTarget methods', () => {
    expect(typeof chatgptTarget.submitQuery).toBe('function')
    expect(typeof chatgptTarget.waitForResponse).toBe('function')
    expect(typeof chatgptTarget.extractAnswer).toBe('function')
    expect(typeof chatgptTarget.extractCitations).toBe('function')
  })
})

// ─── extractAnswer ────────────────────────────────────────────────────────────

describe('chatgptTarget.extractAnswer', () => {
  it('returns the answer text when Runtime.evaluate resolves a non-empty string', async () => {
    const client = makeMockClient('Paris is the capital of France.')
    const text = await chatgptTarget.extractAnswer(client)
    expect(text).toBe('Paris is the capital of France.')
  })

  it('throws CDP_TARGET_SELECTOR_FAILED when answer text is empty', async () => {
    const client = makeMockClient('')
    await expect(chatgptTarget.extractAnswer(client)).rejects.toMatchObject({
      code: 'CDP_TARGET_SELECTOR_FAILED',
    })
  })

  it('throws CDP_TARGET_SELECTOR_FAILED when Runtime.evaluate returns null', async () => {
    const client = makeMockClient(null)
    await expect(chatgptTarget.extractAnswer(client)).rejects.toMatchObject({
      code: 'CDP_TARGET_SELECTOR_FAILED',
    })
  })

  it('throws CDP_TARGET_SELECTOR_FAILED when Runtime.evaluate returns undefined', async () => {
    const client = makeMockClient(undefined)
    await expect(chatgptTarget.extractAnswer(client)).rejects.toMatchObject({
      code: 'CDP_TARGET_SELECTOR_FAILED',
    })
  })
})

// ─── extractCitations ─────────────────────────────────────────────────────────

describe('chatgptTarget.extractCitations', () => {
  it('returns an empty array when no citations are found', async () => {
    const client = makeMockClient([])
    const citations = await chatgptTarget.extractCitations(client)
    expect(citations).toEqual([])
  })

  it('returns grounding sources returned by Runtime.evaluate', async () => {
    const sources = [
      { uri: 'https://example.com/article', title: 'Example Article' },
      { uri: 'https://other.org/page', title: 'Other Page' },
    ]
    const client = makeMockClient(sources)
    const citations = await chatgptTarget.extractCitations(client)
    expect(citations).toEqual(sources)
  })

  it('returns empty array when Runtime.evaluate returns null', async () => {
    const client = makeMockClient(null)
    const citations = await chatgptTarget.extractCitations(client)
    expect(citations).toEqual([])
  })
})
